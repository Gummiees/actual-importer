# Actual Importer

A lightweight Docker-based transaction importer for [Actual Budget](https://actualbudget.org/).

The project is designed to parse bank transaction files, detect duplicates, optionally identify transfers, and import new transactions into Actual Budget.

The importer is intentionally designed to keep **application code separate from user-specific configuration and financial data**.

---

## Features

- Docker-based deployment
- Designed to run continuously and poll an inbox directory
- Parser-based architecture for different banks and file formats
- Transaction deduplication
- Date and amount based transaction matching
- Configurable date tolerance
- Transfer detection
- Automatic transaction categorization through a local regex mapping
- Safe handling of ambiguous transactions
- Automatic organization of processed and failed files
- No bank credentials or personal financial data required by the application
- User-specific configuration kept outside the repository

---

## How it works

The importer watches an inbox directory:

```text
/inbox/
└── <bank>/
    └── <account>/
        └── transactions.csv
```

When a file is detected:

```text
Bank file
   │
   ▼
Parser
   │
   ▼
Normalized transactions
   │
   ├── Duplicate detection
   ├── Transfer detection
   └── Category mapping
   │
   ▼
Actual Budget API
   │
   ▼
Processed
```

If a transaction cannot be matched safely, the importer does not guess.

Ambiguous files are moved to the failed directory instead of being imported.

---

## Requirements

- Docker
- Docker Compose
- A running Actual Budget server
- An Actual Budget Sync ID
- An Actual Budget password
- Bank transaction files supported by an available parser

---

# Configuration

The project intentionally does **not** store real user configuration in Git.

A public repository should never contain:

- Actual Budget passwords
- Personal account IDs
- Private domain names
- Bank statements
- Transaction history
- Personal categorization rules
- Other user-specific financial information

The repository only contains example configuration files.

---

## Actual Budget connection

The importer requires:

```text
ACTUAL_SERVER_URL
ACTUAL_SYNC_ID
ACTUAL_PASSWORD_FILE
```

Example:

```yaml
environment:
  ACTUAL_SERVER_URL: "https://actual.example.com"
  ACTUAL_SYNC_ID: "YOUR_ACTUAL_SYNC_ID"
  ACTUAL_PASSWORD_FILE: "/run/secrets/actual_password"
```

The Actual Budget password should be provided through a Docker secret.

Example:

```yaml
secrets:
  actual_password:
    file: ./secrets/actual_password
```

Create the local secret with:

```bash
mkdir -p secrets
printf '%s\n' 'YOUR_ACTUAL_PASSWORD' > secrets/actual_password
```

The `secrets/` directory must never be committed to Git.

---

# Account configuration

Copy the example configuration:

```bash
cp config/config.example.json config/config.json
```

Example:

```json
{
  "accounts": {
    "bank/account": {
      "actualAccountId": "YOUR_ACTUAL_ACCOUNT_ID",
      "dateToleranceDays": 1,
      "parser": "sabadell"
    }
  }
}
```

The directory structure inside `/inbox` determines which account configuration is used.

For example:

```text
/inbox/
└── sabadell/
    └── principal/
        └── statement.csv
```

maps to:

```json
{
  "accounts": {
    "sabadell/principal": {
      "actualAccountId": "YOUR_ACTUAL_ACCOUNT_ID",
      "dateToleranceDays": 1,
      "parser": "sabadell"
    }
  }
}
```

---

# Category mapping

Transaction categorization is intentionally kept **outside the Git repository**.

Create a local:

```text
mapping.json
```

Start from the included template:

```bash
cp mapping.example.json mapping.json
```

Replace every `REPLACE_WITH_...` value with the **exact** group and category
names from your Actual Budget. `mapping.json` is ignored by Git, so personal
rules stay local.

and mount it into the container:

```yaml
volumes:
  - ./mapping.json:/app/mapping.json:ro
```

The mapping uses regular expressions to determine the Actual Budget category.

Example:

```json
{
  "rules": [
    {
      "name": "Amazon",
      "pattern": "amazon",
      "priority": 50,
      "categoryGroup": "Usual Expenses",
      "category": "Amazon"
    },
    {
      "name": "Netflix",
      "pattern": "netflix",
      "priority": 90,
      "categoryGroup": "Usual Expenses",
      "category": "Subscriptions"
    }
  ]
}
```

Rules are evaluated by priority.

A higher priority rule takes precedence over a lower priority rule.

For example:

```text
amazon prime
     │
     ├── Amazon Prime rule (priority 100)
     └── Amazon rule (priority 50)
```

will be categorized using the more specific rule.

Category names are resolved against the user's Actual Budget categories at runtime.

The mapping therefore does not contain Actual category IDs.

---

# Docker Compose

## Published image and Portainer

Each push to `main` publishes a multi-architecture image for `amd64` and
`arm64` hosts to GitHub Container Registry:

```text
ghcr.io/gummiees/actual-importer:latest
```

For Portainer, deploy the Compose file as a Stack on the NAS. Use absolute NAS
paths for `config.json`, `mapping.json`, the password secret, and the three
data directories. The NAS does not need the repository or a local build.

If the package remains private, create a GitHub personal access token with
read access to Packages and add it to Portainer as a `ghcr.io` registry
credential. Alternatively, make the resulting container package public in
GitHub after the first successful workflow run.

Copy the example Compose file:

```bash
cp compose.example.yml compose.yml
```

Edit it to match your environment.

Example:

```yaml
services:
  actual-importer:
    image: ghcr.io/YOUR_GITHUB_USERNAME/actual-importer:latest
    container_name: actual-importer
    restart: unless-stopped

    environment:
      ACTUAL_SERVER_URL: "https://actual.example.com"
      ACTUAL_SYNC_ID: "YOUR_ACTUAL_SYNC_ID"
      ACTUAL_PASSWORD_FILE: "/run/secrets/actual_password"

    volumes:
      - ./config/config.json:/app/config.json:ro
      - ./mapping.json:/app/mapping.json:ro
      - /path/to/inbox:/inbox
      - /path/to/processed:/processed
      - /path/to/failed:/failed

    secrets:
      - actual_password

secrets:
  actual_password:
    file: ./secrets/actual_password
```

Start the importer:

```bash
docker compose up -d
```

The example Compose file starts with `DRY_RUN: "true"`. In this mode the
importer connects to Actual and reports what it would import, but does not
write transactions or move files out of `/inbox`. Review the logs first:

```bash
docker compose logs -f actual-importer
```

When the parsed transactions, transfer detection and categories look correct,
change the setting to `DRY_RUN: "false"` and restart the container:

```bash
docker compose up -d
```

## Categorizing existing transactions

By default the importer never modifies transactions that are already in
Actual. To categorize an imported history, set `CATEGORIZE_EXISTING: "true"`
while keeping `DRY_RUN: "true"`. It will list only existing transactions that
have no category and match a mapping rule. It skips transfers and split
transactions.

After reviewing the proposed changes, set `DRY_RUN: "false"` and restart the
container once. Set `CATEGORIZE_EXISTING` back to `"false"` afterwards.

View logs:

```bash
docker compose logs -f actual-importer
```

Stop it:

```bash
docker compose down
```

---

# Directory structure

A typical installation may look like:

```text
actual-importer/
├── config/
│   └── config.json
├── mapping.json
├── secrets/
│   └── actual_password
└── compose.yml
```

The financial data directories can live elsewhere:

```text
finance/
├── inbox/
├── processed/
└── failed/
```

They should not be stored inside the Git repository.

---

# File processing

Files are classified into three possible states.

## New transactions

Transactions that do not already exist in Actual Budget are imported.

After successful import:

```text
/inbox/
    ↓
/processed/
```

---

## Existing transactions

Transactions already present in Actual Budget are not imported again.

The source file is moved to:

```text
/processed/
```

---

## Ambiguous transactions

If multiple Actual transactions could correspond to a source transaction and the importer cannot determine the correct match safely, the transaction is considered ambiguous.

The file is not imported and is moved to:

```text
/failed/
```

This is intentional.

The importer prefers requiring manual intervention over potentially creating duplicate or incorrect financial transactions.

---

# Transaction matching

The importer uses multiple pieces of information when determining whether a transaction already exists.

The matching process can include:

1. Stable imported ID
2. Transaction amount
3. Transaction date
4. Payee / description
5. Reference

Date tolerance can be configured per account:

```json
{
  "dateToleranceDays": 1
}
```

For accounts where the source date must match exactly:

```json
{
  "dateToleranceDays": 0
}
```

---

# Transfers

Accounts can optionally define transfer detection.

Example:

```json
{
  "transfer": {
    "targetAccountId": "YOUR_TARGET_ACCOUNT_ID",
    "reference": "YOUR_REFERENCE",
    "concept": "YOUR_TRANSFER_DESCRIPTION"
  }
}
```

When both the configured concept and reference match, the transaction is imported as a transfer to the configured Actual Budget account.

---

# Supported parsers

The importer uses a parser name in the account configuration.

Example:

```json
{
  "parser": "sabadell"
}
```

or:

```json
{
  "parser": "sabadell-card"
}
```

or, for a personal Revolut account statement exported as TSV:

```json
{
  "parser": "revolut"
}
```

Place it in the inbox under the account key configured in `config.json`, for
example `/inbox/revolut/principal/account-statement.tsv`. The `revolut` parser
accepts EUR transactions with the standard Revolut personal-account TSV
columns by default. Set `"currency": "USD"` in that account's configuration
for a USD statement. Reverted rows are skipped. A Revolut fee is included in
the imported amount, so the amount reconciles with the statement balance.

Additional parsers can be added to support other banks and file formats.

---

# Development

Clone the repository:

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/actual-importer.git
cd actual-importer
```

Install dependencies:

```bash
npm install
```

Run the importer:

```bash
npm start
```

Run tests:

```bash
npm test
```

---

# Docker development

Build the image locally:

```bash
docker build -t actual-importer:local .
```

Run it with the required configuration and volumes:

```bash
docker compose up -d
```

---

# Security

This project processes financial data.

Do not commit any of the following:

```text
.env
secrets/
config/config.json
mapping.json
*.csv
*.txt
*.ofx
*.qif
*.qfx
```

The repository intentionally contains only generic examples.

Before publishing or pushing changes, check:

```bash
git status
```

and review staged files:

```bash
git diff --cached
```

Never commit real bank statements or credentials.

---

# Privacy

The importer is designed to run against the user's own Actual Budget instance.

Bank files and transaction data remain on the user's infrastructure.

The project does not require uploading bank statements to a third-party service.

---

# License

See [LICENSE](LICENSE).
