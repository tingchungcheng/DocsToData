# DocsToData

DocsToData lets you chat with your PDFs (quotations, purchase orders, invoices) and save the answers as files on your own computer. It runs on your machine with local Ollama models by default. OpenAI is optional.

## Quick start

From the project folder, run:

```bash
./start.sh
```

Then use the app at **http://localhost:8000/** (the script opens it for you). Press Ctrl+C to stop.

The script sets up whatever is missing and skips anything already done, so you can run it every time:

1. Creates a Python virtual environment in `.venv` (needs Python 3.10 or newer).
2. Installs the packages in `requirements.txt`.
3. Copies `.env.example` to `.env` if you don't have a `.env` yet.
4. Installs Tesseract, used to read scanned PDFs (macOS, with Homebrew).
5. Installs and starts Ollama, then downloads the models named in `.env` (can be several GB the first time). Skipped when `DISABLE_OLLAMA=true`.
6. Starts the app.

Options:

| Command | What it does |
| --- | --- |
| `./start.sh --check` | Only shows what is installed or missing. Changes nothing. |
| `./start.sh --docker` | Runs the app in Docker instead, at http://localhost:8080/ |
| `PORT=9000 ./start.sh` | Uses another port. |
| `NO_BROWSER=1 ./start.sh` | Doesn't open the browser. |

## Using the app

Type `#` in the chat to pick a tool:

- `#ask`: ask a question about the selected PDFs (the default).
- `#compare`: compare quotations and say which vendor is better, and why.
- `#extract`: pull fields and line items out of a PO or invoice.
- `#summarize`: build a summary report you can download.
- `#plan`: a step-by-step plan that uses the documents.
- `#action`: save the latest result to a local folder.

Results are saved under `DOCS_WORKSPACE_DIR` (default `data/workspace`), in one folder per document type, e.g. `Invoices/2026-11/INV-20931.json`. You can rename these folders in Settings. Chats are kept in your browser and shown in History.

The top bar has four sections:

- **Upload & RAG**: the chat. `+` uploads PDFs, Enter asks a question, Summarize builds a report. The provider menu (top right) switches between `ollama` and `openai` for the whole app.
- **Evaluation Dashboard**: save test questions, run them, mark each answer pass or fail, and see the pass rate and speed. Saved in `data/eval_cases.json` and `data/eval_history.json`.
- **Document Library**: see the indexed PDFs with page and chunk counts, and delete one from the index.
- **Account**: sign in and out. Login is off until Cognito is set up (see [Sign-in](#sign-in-aws-cognito-optional)).

**Guest preview:** on the Account screen, **Continue as guest** fills every screen with sample data from `frontend/data/guest-data.json`. Guest mode never calls the backend, so uploading, asking, running evaluations and saving are turned off. Refreshing the page ends guest mode.

## Settings (`.env`)

All settings live in `.env`. `.env.example` lists them all with comments. The main ones:

| Setting | Default | Meaning |
| --- | --- | --- |
| `OLLAMA_CHAT_MODEL` | `qwen3.5:9b` | Local model that writes answers. |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text:latest` | Local model for search. |
| `OLLAMA_VECTOR_DIM` | `768` | Must match the embedding model. |
| `OLLAMA_THINK` | `false` | Thinking mode for qwen3.x models. `false` is much faster. Also `true` or `auto`. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Where Ollama runs. |
| `OPENAI_API_KEY` | empty | Needed only to use OpenAI. |
| `OPENAI_CHAT_MODEL` / `OPENAI_EMBED_MODEL` | `gpt-4o-mini` / `text-embedding-3-small` | OpenAI models. |
| `DISABLE_OLLAMA` | `false` | `true` = OpenAI only (used on Cloud Run). |
| `OCR_ENABLED` | `true` | Read scanned or image-only PDF pages with Tesseract. If Tesseract is missing, those pages are skipped and a warning is logged. |
| `OCR_LANGUAGE` | `eng` | OCR languages, joined with `+`, e.g. `eng+chi_tra`. Extra languages on macOS: `brew install tesseract-lang`. |
| `DOCS_WORKSPACE_DIR` | `data/workspace` | Where saved results go. Any folder works, e.g. `~/Documents/DocsToData`. |
| `CORS_ALLOW_ORIGINS` | `*` | Allowed origins. `*` is fine locally. |
| `GCS_BUCKET` / `GCS_PREFIX` | empty / `go-invoice` | Optional Google Cloud Storage backup (see [Cloud Run](#google-cloud-run)). |
| `COGNITO_*` | empty | Optional sign-in (see [Sign-in](#sign-in-aws-cognito-optional)). |

Restart the app after changing `.env`.

## Manual setup (without the script)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # then edit .env
```

For local models, make sure Ollama is running and the models exist: `ollama list`.

Start the app (web UI and API together):

```bash
uvicorn backend.app:app --reload --host 0.0.0.0 --port 8000
```

- Web UI: http://localhost:8000/
- Health check: http://localhost:8000/health
- API docs: http://localhost:8000/docs

### Command line

Add a PDF and ask about it without the UI:

```bash
# OpenAI
python -m rag.cli ingest --pdf "path/to/file.pdf"
python -m rag.cli query --question "What is this document about?"

# Ollama (local, no API key)
python -m rag_local.cli ingest --pdf "path/to/file.pdf"
python -m rag_local.cli query --question "What is this document about?"
```

### API examples

`POST http://localhost:8000/ingest`

```json
{ "provider": "ollama", "pdf_path": "/path/to/file.pdf" }
```

`POST http://localhost:8000/query`

```json
{ "provider": "ollama", "question": "What is this document about?" }
```

Use `"provider": "openai"` for OpenAI. Other routes: `/ingest-upload` (file upload), `/documents/details`, `DELETE /documents/{provider}/{source}`, `/evaluate/*`.

## Sign-in (AWS Cognito, optional)

Sign-in is off by default: every request is treated as a local user. To require sign-in:

1. In the AWS Console, create a **Cognito User Pool** (or reuse one).
   - Add an **App client**: public, no client secret, with the `ALLOW_USER_PASSWORD_AUTH` flow turned on (`template.yaml` does this for you).
   - Turn on the **Hosted UI**. Set **Allowed callback URLs** and **Allowed sign-out URLs** to your app's URL, e.g. `http://localhost:8000/` locally.
   - Turn on the **Authorization code grant** with scopes `openid email profile`.
   - Pick a **Cognito domain** under "App integration".
   - Optional: add a SAML/OIDC identity provider under "Sign-in experience" for company SSO.
2. Set in `.env`:
   ```
   COGNITO_REGION=us-east-1
   COGNITO_USER_POOL_ID=us-east-1_xxxxxxxxx
   COGNITO_CLIENT_ID=<app client id>
   COGNITO_DOMAIN=https://your-app.auth.us-east-1.amazoncognito.com
   COGNITO_SSO_PROVIDER=        # optional, e.g. MyCompanySSO: shows "Continue with SSO"
   ```
3. Restart the app. Once `COGNITO_REGION`, `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID` are all set, every API route needs a valid login and the UI shows the sign-in screen.

How it works: the sign-in form sends email and password to the backend (`POST /auth/login`), which asks Cognito and returns tokens. The browser keeps them in `sessionStorage`, sends the access token with every call, and renews it with `POST /auth/refresh` when it is about to expire. Sign-up (`/auth/signup`, then `/auth/confirm-signup` with the emailed code) and sign-out (`/auth/logout`) also go through the backend. The backend (`backend/auth.py`) checks every token's signature and client id. "Continue with SSO" uses the Hosted UI redirect instead. The email shown in the UI comes from the id token, because access tokens don't include it.

## Deployment

### Docker (local)

`./start.sh --docker` runs `docker compose up --build -d`. It keeps your `data/` folder and uses Ollama on your computer. Open http://localhost:8080/. Logs: `docker compose logs -f`. Stop: `docker compose down`.

OpenAI only, without compose:

```bash
docker build -t go-invoice:local .
docker run --rm -p 8080:8080 -e DISABLE_OLLAMA=true -e OPENAI_API_KEY=sk-... go-invoice:local
```

The Docker image includes Tesseract.

### Google Cloud Run

Cloud Run uses OpenAI (Ollama doesn't run in the container). Keep the API key in Secret Manager.

```bash
gcloud auth configure-docker
docker build -t gcr.io/PROJECT_ID/go-invoice:latest .
docker push gcr.io/PROJECT_ID/go-invoice:latest
echo -n 'sk-...' | gcloud secrets create openai-api-key --data-file=-     # once
gcloud run deploy go-invoice --image gcr.io/PROJECT_ID/go-invoice:latest --region us-central1 \
  --allow-unauthenticated --set-env-vars DISABLE_OLLAMA=true \
  --set-secrets OPENAI_API_KEY=openai-api-key:latest
```

Open the service URL and pick **OpenAI** in the UI.

- `--allow-unauthenticated` only controls Cloud Run's own access check. If Cognito is set up, the app still requires sign-in.
- The container's disk is temporary: indexes and uploads are lost when the instance is replaced or scales to zero. To keep them, set `GCS_BUCKET` (and optionally `GCS_PREFIX`). Then indexes (`index.faiss`, `chunks.json`) are copied to `gs://<bucket>/<prefix>/indexes/<provider>/` and PDFs to `gs://<bucket>/<prefix>/uploads/`. Queries download missing indexes from there. Check the setup at `/storage-status`.

### AWS (Lambda + Amplify)

The backend can also run as a Lambda container behind an HTTP API, deployed with AWS SAM (`template.yaml`). It uses S3 for uploads and indexes, DynamoDB for evaluations and an optional Cognito user pool. The frontend goes to Amplify Hosting (`amplify.yml`), which writes the API URL (`API_BASE_URL`) into `frontend/js/config.js` at build time.

```bash
sam build
sam deploy --parameter-overrides OpenAiApiKey=sk-... BudgetAlertEmail=you@example.com
```

## Project layout

```
.
├── start.sh            One-command setup and start
├── backend/            FastAPI app (API + serves the UI) and AWS Lambda handler
├── rag/                OpenAI pipeline
├── rag_local/          Ollama pipeline (local)
├── rag_aws/            Bedrock pipeline (AWS)
├── frontend/           Web UI, plain JavaScript, no build step
├── data/               Your uploads, indexes and saved results (not in git)
├── docs/               README, changelog, architecture notes
├── Dockerfile          Image for Cloud Run and local Docker
├── Dockerfile.lambda   Image for AWS Lambda
├── docker-compose.yml  Local Docker (keeps data/, uses Ollama on your computer)
├── template.yaml       AWS SAM stack (Lambda, API Gateway, S3, DynamoDB, Cognito)
├── samconfig.toml      SAM deploy defaults (no secrets)
├── amplify.yml         Amplify Hosting build for the frontend
├── requirements.txt          Python packages
└── requirements-lambda.txt   Extra packages for Lambda only
```

**backend/**
- `app.py`: all routes (chat, Document Library, Evaluation, sign-in).
- `auth.py`: Cognito login and token checks. Open when Cognito isn't set up.
- `eval_store.py`: saves evaluations as JSON files (`EVAL_STORE_BACKEND=json`, default) or in DynamoDB on Lambda (`EVAL_STORE_BACKEND=dynamodb`).
- `lambda_handler.py`: Lambda entry point.
- `runtime_paths.py`: picks writable folders (local disk, or `/tmp` on Lambda).

**rag/** (the other pipelines work the same way)
- `pdf_parser.py`: reads PDF text with PyMuPDF, and uses OCR for scanned pages.
- `chunking.py`: splits text into chunks by token count.
- `retrieval.py`, `vector_store.py`: search with FAISS.
- `evaluation.py`: retrieval and answer-quality scores.
- `pricing.py`: cost estimates.
- `pipeline.py`, `cli.py`: the full flow and the command line.

**frontend/**
- `index.html`, `styles.css`: the page and its sections.
- `js/`: one file per part, e.g. `main.js` (start-up), `api.js` (calls and token refresh), `auth.js` and `authView.js` (sign-in), `guest.js` (guest preview), `uploadRag.js`, `library.js`, `evaluation.js`.
- `assets/`: logo and provider icons. `data/guest-data.json`: guest preview sample data.
