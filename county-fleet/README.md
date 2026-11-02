# County Fleet

A fleet management system for a county government: vehicles and heavy equipment (graders, excavators, water drilling rigs, lorries), drivers, fuel, repairs and servicing, registration and insurance dates, with every cost sent to the county ERP through a reliable queue.

Version 1 scope: sign-in and roles, fleet register, service schedule, repair jobs with parts and cost, fuel with a check against expected use, reports and budget, ERP queue, driver phone screens. Public equipment hire and live M-Pesa are not in this version.

## Run it

Needs Node.js 22.13 or newer. No packages to install.

```
npm start            # http://localhost:3000
```

The first start creates `data/fleet.db`, a sample fleet, and one account per role. Temporary passwords are written to `data/initial-credentials.txt`. Each person must choose their own password at first sign-in. Delete that file after handing the passwords out.

```
npm test             # 12 tests: sign-in, roles, fuel to ERP, retries, review, duplicates
```

## Who can do what

| Role | Can do |
|---|---|
| Administrator | Everything, plus people and the activity log |
| Fleet manager | Add and edit vehicles, record fills, approve fuel, open and close jobs |
| Workshop | Open, start and finish jobs, record meter readings |
| Finance | Approve fuel, set diesel price, run the ERP console, read everything else |
| Driver | See their own vehicle, record fuel, report a fault (phone-sized screens) |

## How fuel is checked

Each vehicle has a fuel use figure: litres per 100 km for road vehicles, litres per engine hour for machines. When a driver gives a new meter reading, the system works out the litres it expected and shows the difference. More than 20% either way is flagged for the approver. Fills without a reading are accepted but cannot be checked.

## How the ERP link works

Nothing is sent to the ERP while a person is waiting. When fuel is approved, a job is opened or finished, or an ERP-relevant field on an asset changes (registration, insurance, cost centre, ERP asset number), the system writes a record to a queue in the same database transaction as the change. A background worker sends the queue.

- **Never lost.** If the ERP is down, records wait and are retried after 30 s, 60 s, 120 s and so on, up to 5 attempts. Then they show as Failed with the reason, and a person can retry after fixing the cause.
- **Never doubled.** Every record has a fixed key (for example `fleet-fuel-143`) sent as the `Idempotency-Key` header. A retry after a lost reply returns the same ERP reference instead of posting twice.
- **A person decides conflicts.** If the ERP answers 409 (for example, dates differ from its asset record), the record goes to Needs review. Finance reads exactly what was sent and chooses Send anyway.
- **Checked by the ERP, not guessed.** Rejections such as a blocked cost centre are shown with the ERP's own message.
- **Secrets stay on the server.** API keys and OAuth secrets come from environment variables only. They are never stored in the database or returned by the API.

### What your ERP team has to provide

Either of these:

1. **A REST endpoint** that follows this contract (the ERP team, or a small gateway in front of SAP, Dynamics, Oracle, Odoo or IFMIS, can implement it):

   - `POST {base}/documents` with `Authorization: Bearer …`, `Idempotency-Key: …` and optional `X-Override: true`. Body is the JSON shown in the ERP console under "Exactly what is sent". Reply `200 {"reference": "PV-26-000123"}`; `409 {"message"}` for a conflict a person must review; `4xx {"message"}` for a rejection; `429/5xx` to be retried.
   - `GET {base}/cost-centres` returning `{"items":[{"code","name","active"}]}`
   - `GET {base}/budgets` returning `{"fy":"2026/27","items":[{"vote","amount"}]}`
   - `GET {base}/vendors` returning `{"items":[{"code","name"}]}`
   - `GET {base}/health`

2. **File exchange.** Choose "Export files for import". One JSON file per record is written to `ERP_EXPORT_DIR/<date>/` for a scheduled import job, and masters are read from `ERP_IMPORT_DIR/cost-centres.json`, `budgets.json`, `vendors.json`.

A different protocol (SOAP, direct database, OData) is a new adapter: one file, `src/erp/adapters.js`, with `send`, `ping` and `pull`. The ledger account names and the target object names per ERP are in Settings and `src/erp/payloads.js`; the ERP team confirms the exact values.

## Demo ERP

When `ENABLE_DEMO_ERP` is on (the default outside production), the server includes a stand-in ERP at `/mock-erp`. In the ERP console an administrator can make it fail twice, or block a cost centre, to practise retries and fixing failures. It is off in production.

## Putting it into service

1. Run behind HTTPS (nginx, Caddy or the county's load balancer). Set `COOKIE_SECURE=1`.
2. Set `NODE_ENV=production`. This turns off the demo ERP and sample data and creates only one administrator.
3. Set the ERP secrets in the environment (see `.env.example`), then enter the ERP address in the ERP console and press Test connection, then Bring in budgets and cost centres.
4. Back up the single file `DB_FILE` every night, for example `sqlite3 /data/fleet.db ".backup '/backups/fleet-$(date +%F).db'"`. Keep copies off the server.
5. Docker: `docker build -t county-fleet .` then `docker run -p 3000:3000 -v fleet-data:/data --env-file .env county-fleet`.

## Security notes

Passwords are hashed with scrypt, at least 10 characters with letters and numbers; temporary passwords must be changed at first use. Sign-in cookies are HttpOnly and SameSite=Strict; five wrong passwords lock that email and address for 15 minutes. Every change request must carry a custom header, which browsers will not send from another site. The page security policy blocks inline scripts and styles. Roles are enforced on the server, not only in the screens. Every action is in the activity log.

Before real use, have the county's ICT or security team review it, and add rate limiting and TLS at the proxy.

## What is not here yet

Public equipment hire and payments, GPS tracking, SMS or email alerts for due services and expiries, photos of faults, offline use for drivers in poor coverage, and importing the existing asset register. Each can be added on the same foundation.

## Layout

```
server.js            start-up
src/db.js            tables
src/services.js      fleet, fuel, jobs, reports
src/routes.js        the API and who may call each part
src/erp/             outbox, adapters, payload builder, demo ERP
public/              the web app (no build step)
test/                automated tests
```
